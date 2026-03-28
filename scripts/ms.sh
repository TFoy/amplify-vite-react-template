#!/usr/bin/bash
#{ head -n 1 out_with_volume.txt; tail -n +2 out_with_volume.txt | sort -t $'\t' -g -r -k11,11; }
sort -t $'\t' -g -r -k12,12 out_with_volume_2.txt | awk -F'\t' '$7 > 20000' > out_with_volume_2_sorted.txt
#awk -F',' '{ key=$(NF-1); print key "\t" $0 }' out_with_volume.txt | sort -k1,1nr | cut -f2-
